# KaTeX 0.19.0

Official MIT-licensed distribution from https://katex.org/.
Source package: https://registry.npmjs.org/katex/-/katex-0.19.0.tgz

SHA-512 (npm integrity):
`sha512-v6Tznz3zJ7u3niRCoDTsumM2+HA2XXcCu+WAacCeHD2z3p9A9Ks987o5FzfTGBN0e8A0vjEgIDvLbICrXpdw/Q==`

Vendored files are unmodified copies of `dist/katex.mjs` (named `katex.js`
so existing static servers serve it as JavaScript), `dist/katex.min.css`,
`dist/fonts/*`, and `LICENSE`. Keep the engine, stylesheet, fonts and license
at the same version when updating. The files are included by the existing
`public/**` desktop packaging rule; rendering does not use a CDN or network.

To obtain the pinned source package without running package scripts:

```sh
npm pack katex@0.19.0 --ignore-scripts
```
