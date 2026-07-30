# Vendored browser assets

Third-party browser code committed here rather than pulled from a CDN, so that
markserv-marker keeps working without a network connection. Everything under
`lib/` is served by the `{markserv}` asset handler and shipped in the npm
package (`files: ["lib"]` in package.json), so no build or install step is
involved.

`xo` does not lint this directory — see `xo.ignores` in package.json.

## mermaid.min.js

| | |
| --- | --- |
| Package | [mermaid](https://github.com/mermaid-js/mermaid) |
| Version | 11.16.0 |
| License | MIT |
| Source | <https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js> |

This is the self-contained UMD build. It defines `globalThis.mermaid` and
loads no further chunks at runtime, which is why a single `<script>` tag is
enough. `lib/templates/mermaid.js` injects that tag lazily, only on pages that
actually contain a mermaid block, because the file is around 3.5 MB.

To update, download the new version over this file and bump the version above:

```console
curl -sL -o lib/vendor/mermaid.min.js \
  https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js
```

Then hard-reload the browser: `send` serves the file with an ETag, so a normal
reload may keep the old copy.
