import { KappaLink } from '.';

describe('Sanity Test', () => {
  test('named import KappaLink should be a function', () => {
    expect(KappaLink).toBeDefined();
    expect(KappaLink).toBeInstanceOf(Function);
  });
});
