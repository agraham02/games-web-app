# Fonts

Latin subset, `woff2`, all four from Google Fonts (SIL Open Font License 1.1):
Cinzel, Figtree, Jost and Source Serif 4 (each one variable-weight file), plus Bricolage
Grotesque and Instrument Serif for the two design pages under `lab/design`.

They are served from here with `next/font/local`, not fetched at build time with
`next/font/google`. Google intermittently answers with font URLs of the form
`fonts.gstatic.com/l/font?kit=...&skey=...&v=...`, which Turbopack's
`next/font/google` cannot read ("queries have exactly one entry"), and whichever
build drew that response failed (the container image on 2026-11-01, the
production build another time). A build should not depend on an outside service.

To change a font, download the latin `woff2` from its Google Fonts CSS and replace the file.
