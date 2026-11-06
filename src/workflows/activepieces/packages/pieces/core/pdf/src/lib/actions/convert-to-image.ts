// THIS FILE IS A JARVIS STUB (#961).
// Upstream's "Convert to Image" action writes the PDF under the OS temp dir and
// runs poppler's `pdftoppm` on it through `/bin/sh`, with the engine's own
// environment: a child process and files outside the run, which the core PDF
// piece's other actions never need and the in-run rule does not allow. The
// action is not loaded (the piece's index no longer lists it), and this stub
// keeps the path so a vendor sync notices if upstream moves it.

export {};
