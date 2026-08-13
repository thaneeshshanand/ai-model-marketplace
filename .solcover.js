/**
 * solidity-coverage configuration.
 *
 * `mocks/` holds test-only harness contracts that exist to reach defensive branches
 * unreachable through the public API. They are excluded from the coverage denominator
 * because they are never deployed and measuring coverage of test scaffolding would
 * inflate the reported figure.
 */
module.exports = {
  skipFiles: ["mocks"]
};