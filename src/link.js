//
// Copyright 2019 Wireline, Inc.
//

import { ApolloLink, Observable } from 'apollo-link';
import { hasDirectives, getMainDefinition, getDirectiveInfoFromField } from 'apollo-utilities';
import { visit, BREAK } from 'graphql/language/visitor';
import { graphql } from 'graphql-anywhere/lib/async';
import { print } from 'graphql';

// TODO(burdon): ???
function normalizeTypeDefs(typeDefs) {
  const defs = Array.isArray(typeDefs) ? typeDefs : [typeDefs];

  return defs
    .map(typeDef => (typeof typeDef === 'string' ? typeDef : print(typeDef)))
    .map(str => str.trim())
    .join('\n');
}

// TODO(burdon): Util.
const capitalizeFirstLetter = str => str.charAt(0).toUpperCase() + str.slice(1);

/**
 * Add typename to data.
 */
const setTypename = (data, fieldName) => {
  if (data && typeof data === 'object' && !data.__typename) {
    if (data instanceof Array) {
      return data.map((item) => {
        // eslint-disable-next-line no-param-reassign
        item.__typename = capitalizeFirstLetter(fieldName);
        return item;
      });
    }
    // eslint-disable-next-line no-param-reassign
    data.__typename = capitalizeFirstLetter(fieldName);
  }

  return data;
};

/**
 * Apollo data link adapter for Kappa.
 * Maps GraphQL queries and subscriptions onto kappa views.
 */
export class KappaLink extends ApolloLink {

  /**
   * @param {{ api }} kappa
   * @param {{ swarm }} framework
   * @param resolvers
   * @param fragmentMatcher
   * @param [typeDefs]
   */
  constructor({ kappa, framework, resolvers, fragmentMatcher, typeDefs }) {
    super();

    // TODO(burdon): Assert non-optional.

    this._kappa = kappa;
    this._framework = framework;
    this._resolvers = resolvers;
    this._fragmentMatcher = fragmentMatcher;
    this._typeDefs = typeDefs;
  }

  // https://www.apollographql.com/docs/link/overview.html#request
  request(operation, forward) {
    if (this._typeDefs) {
      const definition = normalizeTypeDefs(this._typeDefs);
      const directives = 'directive @kappa on FIELD';

      operation.setContext(({ schemas = [] }) => ({
        schemas: schemas.concat([{ definition, directives }])
      }));
    }

    operation.setContext(prevContext => ({
      ...prevContext,
      kappa: this._kappa,
      framework: this._framework
    }));

    // Ignore if not a kappa query.
    if (!hasDirectives(['kappa'], operation.query)) {
      return forward && forward(operation);
    }

    const def = getMainDefinition(operation.query);
    const resolvers = typeof this._resolvers === 'function' ? this._resolvers() : this._resolvers;
    const type = capitalizeFirstLetter(def.operation || 'Query');
    // console.log('ApolloLink.request:', type + ':' + operation.operationName);

    switch (type) {
      case 'Mutation':
      case 'Query': {
        return this.runQuery({ type, resolvers, operation, forward });
      }

      case 'Subscription': {
        return this.runSubscription({ type, resolvers, operation, forward });
      }

      default: {
        console.error('Invalid type:', type);
      }
    }
  }

  // Queries must be set with police: 'network-only till we figure out a better way to return all items everytime.'
  runQuery({ type, resolvers, operation }) {
    const resolver = async (fieldName, rootValue = {}, args, context, info) => {
      const { resultKey, directives } = info;

      // If we set @kappa(method) then directive { kappa: { view, method } } otherwise { kappa: null }
      if (directives && directives.kappa) {
        const { view, method } = directives.kappa;
        return this._kappa.api[view][method](args || undefined);
      }

      // Support GraphQL aliases.
      const aliasNeeded = resultKey !== fieldName;
      const aliasedNode = rootValue[resultKey];
      const preAliasingNode = rootValue[fieldName];

      // If aliasedValue is defined, some other link or server already returned a value.
      if (aliasedNode !== undefined || preAliasingNode !== undefined) {
        return aliasedNode || preAliasingNode;
      }

      // Look for the field in the custom resolver map (either property or method).
      const resolverMap = resolvers[rootValue.__typename || type];
      if (resolverMap) {
        const resolve = resolverMap[fieldName];
        if (typeof resolve === 'function') {
          const data = await resolve(rootValue, args, context, info);
          return setTypename(data, fieldName);
        }
        // TODO(burdon): This is typically null (e.g., for __typename). What should be returned?
        return resolve;
      }

      return (
        // Support nested fields.
        (aliasNeeded ? aliasedNode : preAliasingNode) || null
      );
    };

    return new Observable((observer) => {
      const observerErrorHandler = observer.error.bind(observer);

      this._kappa.ready(() => {
        graphql(resolver, operation.query, {}, operation.getContext(), operation.variables, {
          fragmentMatcher: this._fragmentMatcher
        })
          .then((nextData) => {
            observer.next({
              data: nextData
            });

            observer.complete();
          })
          .catch(observerErrorHandler);
      });
    });
  }

  runSubscription({ type, resolvers, operation, forward }) {
    const subscriptionResolvers = resolvers[type] || {};

    let field = null;
    visit(operation.query, {
      Field(node) {
        if (node.directives && node.directives.find(d => d.name.value === 'kappa')) {
          field = node;
          return BREAK;
        }
      }
    });

    if (!field && forward) {
      return forward(operation);
    }

    const name = field.name.value;
    const directive = getDirectiveInfoFromField(field);

    let resolver;
    if (directive.kappa) {
      const { view, event } = directive.kappa;
      const { filter } = subscriptionResolvers[name] || {};

      resolver = (_, args, { next }) => {
        const onEvent = (data) => {
          if (filter) {
            if (filter(data, args)) {
              next(data);
            }
          } else {
            next(data);
          }
        };

        this._kappa.api[view].events.on(event, onEvent);

        return () => {
          this._kappa.api[view].events.removeListener(event, onEvent);
        };
      };
    } else {
      resolver = subscriptionResolvers[name];
    }

    if (!resolver) {
      console.warn(`No resolver registered for ${name}`);
    }

    return {
      subscribe: (observer) => {
        const observerErrorHandler = observer.error.bind(observer);

        let unsubscribe;
        this._kappa.ready(() => {
          unsubscribe = resolver && resolver({}, operation.variables, {
            ...operation.getContext(),

            next(data) {
              const nextData = setTypename(data, name);
              observer.next({ data: { [name]: nextData } });
            },

            error(err) {
              observerErrorHandler(err);
            }
          });
        });

        return {
          unsubscribe() {
            if (unsubscribe) {
              unsubscribe();
            }
          }
        };
      }
    };
  }
}
