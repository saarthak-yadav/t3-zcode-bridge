# Making the ZCode bridge distributable and official

Checked upstream documentation on 2026-10-09. Version 0.2.0 is an experimental GitHub preview release under MIT. It is not yet suitable for ACP Registry submission or official vendor support.

## Recommended route

1. Make a portable standalone ACP agent, then submit it to the ACP Registry. Current T3 main documents generic registry providers and local ACP commands, so a dedicated provider implementation may be unnecessary. Our installed T3 0.0.45 still requires the Grok compatibility driver.
2. Ask Z.ai whether they will adopt, maintain or endorse the ACP adapter, using existing ACP request #585 or #571. Registry inclusion alone does not make a bridge official Z.ai software.
3. If T3-specific code changes are needed, agree on the direction and scope in a T3 Ideas discussion first. Their contribution policy requires explicit maintainer approval for new features before a PR; a discussion link by itself is insufficient.

Sources:
- https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md
- https://github.com/pingdotgg/t3code/blob/main/CONTRIBUTING.md#prior-approval
- https://github.com/zai-org/feedback/issues/585
- https://github.com/zai-org/feedback/issues/571
- https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md
- https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md

## Work needed before release

- Discover a supported ZCode CLI installation on each supported runtime platform, or use a vendor-approved CLI distribution. The Node/source launcher paths are now portable; the default ZCode resource location still targets macOS.
- Keep releases restricted to source, documentation and synthetic fixtures. MIT and `saarthak-yadav/t3-zcode-bridge` were selected by the owner; settings backups and credentials are excluded.
- Replace the legacy account-config dependency with a documented ZCode credential API or supported login integration. Implement a real Agent Auth or Terminal Auth flow; the current existing-account check does not meet the registry's onboarding requirement.
- Add a supported ZCode protocol/CLI version range and clear compatibility failures. Preserve real semantic version reporting for generic ACP, and isolate the Grok-specific version probe behavior to legacy compatibility mode.
- Verify generic ACP v1 integration on current T3; plan ACP v2 migration independently. Test cold start, auth failure, model switching, permissions, cancellation, native resume, image-only prompts, documents, binary files and missing/oversized files on supported platforms.
- Preserve structured questions via supported elicitation, implement session listing/import and context usage where the native API allows, and accurately advertise only implemented capabilities.
- Define attachment storage retention and deletion, and show clearly when a file is referenced rather than directly understood. Validate MIME/content and native media compatibility; enforce transport size bounds before parsing the full JSON line.
- Extend the GitHub preview package/checksum and automated tests into a maintained distribution/update policy. npm registry publication is not configured.
- Prepare a registry entry with distribution, semantic version, license URL and required monochrome SVG icon; run registry schema and protocol/auth checks before submitting.

## Draft proposal for maintainers (not sent)

We have a local ACP v1 adapter driving ZCode's bundled `app-server --stdio`, verified with ZCode Desktop 3.14.4 / CLI 0.16.9 and T3 Code 0.0.45. It uses the native agent harness and existing Coding Plan configuration, with streaming, permission decisions, model selection, cancellation and process-restart session resume. Version 0.2 adds image, PDF, embedded text and file resource translation, including private staging for binary resources. Live checks verify image and document comprehension; file-link conversion and attachment limits have automated coverage.

We would like to agree on a supported native protocol/auth boundary and ownership for an ACP bridge, then distribute it through the ACP Registry for generic T3/editor compatibility. Can Z.ai adopt or endorse this direction, and what API/CLI distribution and authentication flow should the bridge target? For T3, does the current generic ACP provider cover this integration, or is a narrowly scoped compatibility change needed?

The owner authorized a public GitHub repository and preview release. No maintainer proposal, registry entry or upstream pull request has been submitted.
