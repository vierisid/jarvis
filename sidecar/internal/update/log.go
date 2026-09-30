package update

import "log"

// Logf receives the package's warnings (an unpinned signature check, a
// leftover that could not be cleaned). The installer points it at its own
// stderr logger; the sidecar keeps the default, which lands in sidecar.log.
var Logf = func(format string, args ...any) { log.Printf(format, args...) }
