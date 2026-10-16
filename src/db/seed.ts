type Queryable = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{
    rows: Array<{
      id: string;
      name: string;
      monthly_allowance: string;
      max_units_per_request: string;
      owner_account_id: string | null;
      is_predefined: boolean;
    }>;
    rowCount: number | null;
  }>;
};

type PlanKind = "account" | "user";

type PredefinedPlan = {
  kind: PlanKind;
  name: string;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
};

export const PREDEFINED_PLANS: readonly PredefinedPlan[] = [
  {
    kind: "account",
    name: "Starter",
    monthlyAllowance: "10000",
    maxUnitsPerRequest: "100",
  },
  {
    kind: "account",
    name: "Pro",
    monthlyAllowance: "100000",
    maxUnitsPerRequest: "1000",
  },
  {
    kind: "user",
    name: "Basic",
    monthlyAllowance: "1000",
    maxUnitsPerRequest: "20",
  },
  {
    kind: "user",
    name: "Premium",
    monthlyAllowance: "5000",
    maxUnitsPerRequest: "100",
  },
];

export async function seedPredefinedPlans(
  db: Queryable,
): Promise<{ inserted: number; unchanged: number }> {
  let insertedCount = 0;
  let unchangedCount = 0;

  for (const plan of PREDEFINED_PLANS) {
    const table = plan.kind === "account" ? "account_plans" : "user_plans";
    const inserted = await db.query(
      `
        INSERT INTO ${table} (
          owner_account_id,
          name,
          monthly_allowance,
          max_units_per_request,
          is_predefined
        )
        VALUES (NULL, $1, $2, $3, true)
        ON CONFLICT (name) WHERE owner_account_id IS NULL DO NOTHING
        RETURNING id, name, monthly_allowance, max_units_per_request,
                  owner_account_id, is_predefined
      `,
      [plan.name, plan.monthlyAllowance, plan.maxUnitsPerRequest],
    );

    const existing = inserted.rows[0] ?? (await db.query(
      `
        SELECT id, name, monthly_allowance, max_units_per_request,
               owner_account_id, is_predefined
        FROM ${table}
        WHERE name = $1 AND owner_account_id IS NULL
      `,
      [plan.name],
    )).rows[0];

    if (inserted.rows.length > 0) {
      insertedCount += 1;
    } else {
      unchangedCount += 1;
    }

    if (
      !existing
      || existing.owner_account_id !== null
      || existing.is_predefined !== true
      || existing.monthly_allowance !== plan.monthlyAllowance
      || existing.max_units_per_request !== plan.maxUnitsPerRequest
    ) {
      throw new Error(
        `Predefined ${plan.kind} plan "${plan.name}" exists with unexpected ownership or values; no existing definition was changed.`,
      );
    }
  }

  return { inserted: insertedCount, unchanged: unchangedCount };
}
