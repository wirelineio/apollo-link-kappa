//
// Copyright 2019 Wireline, Inc.
//

import { ApolloLink, Observable } from 'apollo-link';
import { hasDirectives, getMainDefinition, getDirectiveInfoFromField } from 'apollo-utilities';
import { visit, BREAK } from 'graphql/language/visitor';
import { graphql } from 'graphql-anywhere/lib/async';
import { print } from 'graphql';

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
      return data.map(item => ({
        __typename: capitalizeFirstLetter(fieldName),
        ...item
      }));
    }

    return {
      ...data,
      __typename: capitalizeFirstLetter(fieldName)
    };
  }

  return data;
};

/**
 * Apollo data link adapter for Kappa.
 * Maps GraphQL queries and subscriptions onto kappa views.
 */
export class KappaLink extends ApolloLink {

  constructor({ kappa, resolvers, typeDefs, fragmentMatcher }) {

    super();

    this.kappa = kappa;
    this.resolvers = resolvers;
    this.typeDefs = typeDefs;
    this.fragmentMatcher = fragmentMatcher;
  }

  // https://www.apollographql.com/docs/link/overview.html#request
  request(operation, forward) {
    const { kappa, typeDefs } = this;

    // TODO(burdon): Not set.
    if (typeDefs) {
      const definition = normalizeTypeDefs(typeDefs);
      const directives = 'directive @kappa on FIELD';

      operation.setContext(({ schemas = [] }) => ({
        schemas: schemas.concat([{ definition, directives }])
      }));
    }

    operation.setContext(prevContext => ({
      ...prevContext,
      kappa
    }));

    // Ignore if not a kappa query.
    if (!hasDirectives(['kappa'], operation.query)) {
      return forward && forward(operation);
    }

    const def = getMainDefinition(operation.query);
    const resolvers = typeof this.resolvers === 'function' ? this.resolvers() : this.resolvers;
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
    const { kappa, fragmentMatcher } = this;

    const resolver = async (fieldName, rootValue = {}, args, context, info) => {
      const { resultKey, directives } = info;

      // If we set @kappa(method) then directive { kappa: { view, method } } otherwise { kappa: null }
      if (directives && directives.kappa) {
        const { view, method } = directives.kappa;
        return kappa.api[view][method](args || undefined);
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

      kappa.ready(() => {
        graphql(resolver, operation.query, {}, operation.getContext(), operation.variables, {
          fragmentMatcher
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
    const { kappa } = this;
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
        kappa.api[view].events.on(event, onEvent);

        return () => {
          kappa.api[view].events.removeListener(event, onEvent);
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

        kappa.ready(() => {
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
      },
    };
  }
}
