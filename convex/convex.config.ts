import rag from "@convex-dev/rag/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(rag);

export default app;
