// `pq1-sdk/testing`: fakes for testing a PQ1 integration without hardware.
// Never ship these in a production build.

export { FakePq1Device, FAKE_USEROP_SIGNATURE } from './fakeDevice'
export type { FakeCommand, FakePq1DeviceOptions } from './fakeDevice'
export { createFakeChain, createFakeBundler, FAKE_VERIFIER } from './fakeChain'
export type { FakeChainOptions, FakeBundlerOptions } from './fakeChain'
export { installFakeHid } from './installFakeHid'
