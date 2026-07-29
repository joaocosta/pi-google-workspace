# Project guidance

When a Google Workspace API operation's parameters, scopes, or response shape are unclear, use the optional `gws` CLI for discovery.

List available services and navigate progressively through the resource hierarchy with `--help`:

    gws --help
    gws <service> --help
    gws <service> <resource> --help
    gws <service> <resource> [sub-resource ...] --help

For example:

    gws gmail users messages attachments --help

Infer schema paths from existing `googleapis` calls when possible—for example, `client.users.messages.get` maps to `gmail.users.messages.get`—then inspect the selected method:

    gws schema <service.resource.[sub-resource.]method>

Schema inspection and `--help` are safe discovery operations. Do not make authenticated Google Workspace calls unless the user explicitly requests live validation.
