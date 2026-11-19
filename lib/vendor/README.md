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
| Version | 11.16.1 |
| License | MIT |
| Source | <https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.min.js> |

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

## mathjax/

| | |
| --- | --- |
| Package | [mathjax](https://github.com/mathjax/MathJax) |
| Version | 3.2.2 |
| License | Apache-2.0 (`mathjax/LICENSE`) |
| Source | npm registry tarball `mathjax-3.2.2.tgz`, integrity `sha512-Bt+SSVU8eBG27zChVewOicYs7Xsdt40qm4+UpHyX7k0/O9NliPc+x77k1/FEsPsjKPZGJvtRZM1vO+geW0OhGw==` |

`lib/templates/markdown.html` loads `{markserv}vendor/mathjax/tex-mml-chtml.js`.
MathJax takes the folder of that script's `src` as its `[mathjax]` path, so
everything it fetches later comes from this copy too, and the page's
`'strict-dynamic'` policy lets the scripts it inserts run. Only what this
component reaches at runtime is copied from the package's `es5/` tree, about
2 MB of its 23 MB:

- `tex-mml-chtml.js` — the combined component: TeX and MathML input, CommonHTML
  output, the menu and assistive MathML. Byte-identical to the jsDelivr file
  the template used to load.
- `output/chtml/fonts/woff-v2/` — the fonts CommonHTML output loads.
- `input/tex/extensions/` — the TeX packages `autoload` and `\require` fetch
  when a formula uses, say, `\color`, `\cancel` or `\ce`.

Left out: `sre/` and `a11y/` beyond assistive MathML, which the menu loads
only when a reader turns on its speech or explorer options (those requests
404), the SVG output, and the other combined components.

To update, verify and unpack the tarball in an empty scratch directory and
copy the same three things over this folder, along with `LICENSE`:

```console
npm pack mathjax@<version>
npm view mathjax@<version> dist.integrity   # compare with:
echo "sha512-$(openssl dgst -sha512 -binary mathjax-<version>.tgz | base64)"
tar -xzf mathjax-<version>.tgz
```
