import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { serializeSandboxMetadata } from "./lib/sandbox-lifecycle";

export default defineSandbox({
  backend: serializeSandboxMetadata(justbash()),
});
