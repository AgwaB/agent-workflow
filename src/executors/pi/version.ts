// Dependency-free identity of the Pi executor adapter. The core executor registry imports only
// this file to build the built-in descriptor (it must not pull the adapter itself into core).
export const PI_EXECUTOR_ID = "pi";
export const PI_EXECUTOR_VERSION = "0.1.0";
/** WP17 first-run guidance: the command that installs this CLI (named when it is missing). */
export const PI_INSTALL_COMMAND = "npm i -g @earendil-works/pi-coding-agent";
