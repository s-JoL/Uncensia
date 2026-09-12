import { randomBytes } from "node:crypto";
/** 48-bit identifiers remain exact JS integers and preserve the citation protocol. */
export const nextCitationId = () => randomBytes(6).readUIntBE(0, 6);
