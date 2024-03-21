import dotenv from "dotenv";

dotenv.config();

export const privateKey =
  process.env.PRIVATE_KEY_FILE === undefined
    ? "./keys/key.key"
    : process.env.PRIVATE_KEY_FILE;
export const certificate =
  process.env.CERTIFICATE_FILE === undefined
    ? ".keys/certificate.crt"
    : process.env.CERTIFICATE_FILE;
