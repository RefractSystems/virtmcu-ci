# virtmcu-ci GitHub Action

GitHub Action to exchange OIDC tokens and execute simulation test cases on VirtMCU CI.

## Usage

```yaml
- uses: RefractSystems/virtmcu-ci@<sha> # v1
  with:
    registration-id: ${{ vars.VIRTMCU_REGISTRATION_ID }}
    token-endpoint: ${{ vars.VIRTMCU_TOKEN_ENDPOINT }}
    resource: ${{ vars.VIRTMCU_RESOURCE }}
```
