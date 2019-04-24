# @wirelineio/apollo-link-kappa

[![CircleCI](https://circleci.com/gh/wirelineio/apollo-link-kappa.svg?style=svg&circle-token=a60a9027dcab604ae0c4ed6dd2c93774b2211ebd)](https://circleci.com/gh/wirelineio/apollo-link-kappa)

Run Queries and Mutations against kappa views.

## Quick Start

To get started, install `@wirelineio/apollo-link-kappa` from npm:

```
npm install @wirelineio/apollo-link-kappa
```

The rest of the instructions assume that you have already [set up Apollo Client](https://www.apollographql.com/docs/react/basics/setup.html#installation) in your application. 

After you install the package, you can create your kappa link by calling `KappaLink` constructor and passing your kappa instance and a set of resolvers:

```js
import { KappaLink } from '@wirelineio/apollo-link-kappa';

const kappaLink = new KappaLink({
  kappa: kappaCore,
  resolvers: kappaResolvers
});

```
