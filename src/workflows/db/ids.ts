/**
 * 21-char nanoid in the same alphabet activepieces uses (`apId()`), so IDs we
 * generate are interchangeable with vendored code's expectations.
 */

import { customAlphabet } from "nanoid";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 21;

export const apId: () => string = customAlphabet(ALPHABET, ID_LENGTH);
