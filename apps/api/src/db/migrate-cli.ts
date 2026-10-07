import { loadConfig } from "../config";
import { migrate } from "./migrate";
import { createPool } from "./pool";
import { seedReferenceData } from "./seed";

const config = loadConfig();
const db = createPool(config.DATABASE_URL, 2);
const applied = await migrate(db);
await seedReferenceData(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Schema up to date");
await db.end();
