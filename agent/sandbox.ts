import {
  defaultBackend,
  defineSandbox,
  type SandboxNetworkPolicy,
} from "eve/sandbox";

const githubOnly: SandboxNetworkPolicy = {
  allow: ["github.com", "*.github.com", "*.githubusercontent.com"],
  subnets: {
    deny: [
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ],
  },
};

export default defineSandbox({
  backend: defaultBackend({
    vercel: { networkPolicy: githubOnly, resources: { vcpus: 2 } },
    microsandbox: {
      cpus: 2,
      memoryMiB: 4096,
      networkPolicy: githubOnly,
    },
    // Docker cannot broker per-domain credentials. Keep its local fallback
    // offline; microsandbox is the faithful local security model.
    docker: { networkPolicy: "deny-all" },
  }),
});
