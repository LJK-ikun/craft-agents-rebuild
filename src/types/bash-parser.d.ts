declare module "bash-parser" {
  // bash-parser returns a shell syntax tree; validation narrows unknown nodes itself.
  export default function parseBash(command: string): unknown;
}
