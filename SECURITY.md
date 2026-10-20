# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**. Include a description, the affected version, and steps to reproduce.

Problems in the PQ1 firmware or its contracts belong to [EthereumPhone/PQ1](https://github.com/EthereumPhone/PQ1); report them there the same way.

## Scope

In scope: anything in this repository that could make a user sign something other than what they were shown, sign with the wrong account or device, leak private data, or lose funds. That includes the wire format, clear-signing bundles, fee handling, the dApp-provider helpers, and the example's handling of requests.

The example wallet in `examples/` is for development. Report problems in it, but don't run it with real funds.

## For integrators

[docs/security.md](docs/security.md) lists the rules your integration has to keep.
