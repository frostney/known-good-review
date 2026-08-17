import {
  defaultBackend,
  defineSandbox,
} from "eve/sandbox";
import { githubOnlyNetworkPolicy } from "../src/github/review-workspace";

export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      networkPolicy: githubOnlyNetworkPolicy,
      resources: { vcpus: 2 },
    },
    microsandbox: {
      cpus: 2,
      memoryMiB: 4096,
      networkPolicy: githubOnlyNetworkPolicy,
    },
    // Docker cannot broker per-domain credentials. Keep its local fallback
    // offline; microsandbox is the faithful local security model.
    docker: { networkPolicy: "deny-all" },
  }),
});
