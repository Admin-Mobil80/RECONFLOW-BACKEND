# ReconFlow — Backend

Backend services and APIs for ReconFlow.

Part of the [WingTheIdea](https://github.com/Admin-Mobil80) group.

## Status

Scaffold only — no application code yet.

## AWS

Resources live in the shared account `231427841372`. Authenticate with:

```bash
aws sso login --profile wingtheidea
```

Always pass `--profile wingtheidea`; resources are co-tenant with other products, so prefix anything created here with `reconflow-backend-`.
