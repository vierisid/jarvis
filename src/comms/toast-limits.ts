/**
 * Longest title and body a desktop toast shows, in code points. A leaf module
 * so text writers (the workflow runtime's notices, #1080) can size what they
 * send without importing the toast launcher, which spawns.
 */
export const TOAST_TITLE_MAX = 100;
export const TOAST_BODY_MAX = 200;
