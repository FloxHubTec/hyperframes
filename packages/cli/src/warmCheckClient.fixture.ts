// fallow-ignore-file unused-file
import { runWarmCheck } from "./warmCheckClient.js";

const [address = "", ...args] = process.argv.slice(2);
process.argv = [process.argv[0]!, process.argv[1]!, ...args];
if (!(await runWarmCheck(address))) process.stdout.write("NOT SERVED\n");
