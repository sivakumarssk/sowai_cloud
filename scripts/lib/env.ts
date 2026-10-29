// Every script checks its environment right after loading .env (see src/lib/environment.ts).
import { environmentProblems, productionOnlyProblem } from "../../src/lib/environment";

/** Exits with the reasons when this environment must not run (or, with `productionOnly`, isn't production). */
export function exitUnlessEnvironment(productionOnly?: string): void {
  const problems = environmentProblems();
  const problem = productionOnly
    ? productionOnlyProblem(productionOnly)
    : problems.length > 0
      ? `Refusing to start (APP_ENV=${process.env.APP_ENV?.trim() || "unset"}):\n  - ${problems.join("\n  - ")}`
      : null;
  if (!problem) return;
  console.error(problem);
  process.exit(1);
}
