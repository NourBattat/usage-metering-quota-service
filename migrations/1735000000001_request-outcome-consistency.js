export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE consumption_requests
      ADD CONSTRAINT consumption_requests_outcome_details_check CHECK (
        (
          status = 'accepted'
          AND jsonb_array_length(rejection_reasons) = 0
          AND cardinality(failed_rule_levels) = 0
        )
        OR (
          status = 'rejected'
          AND jsonb_array_length(rejection_reasons) > 0
          AND cardinality(failed_rule_levels) > 0
        )
      );

    COMMENT ON COLUMN account_plans.monthly_allowance IS
      'Assumption: capped at 9 quadrillion units to stay safely within PostgreSQL BIGINT and JavaScript exact integer boundaries.';
    COMMENT ON COLUMN account_plans.max_units_per_request IS
      'Assumption: request units are capped at 1,000,000 to keep individual requests bounded.';
    COMMENT ON COLUMN user_plans.monthly_allowance IS
      'Assumption: capped at 9 quadrillion units to stay safely within PostgreSQL BIGINT and JavaScript exact integer boundaries.';
    COMMENT ON COLUMN user_plans.max_units_per_request IS
      'Assumption: request units are capped at 1,000,000 to keep individual requests bounded.';
    COMMENT ON COLUMN account_monthly_usage.month IS
      'UTC calendar month represented by its first date; application computes this month in UTC.';
    COMMENT ON COLUMN user_monthly_usage.month IS
      'UTC calendar month represented by its first date; application computes this month in UTC.';
    COMMENT ON COLUMN user_monthly_usage.used_units IS
      'Independent usage total for this user and UTC month; historical rows are retained.';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE consumption_requests
      DROP CONSTRAINT IF EXISTS consumption_requests_outcome_details_check;
    COMMENT ON COLUMN account_plans.monthly_allowance IS NULL;
    COMMENT ON COLUMN account_plans.max_units_per_request IS NULL;
    COMMENT ON COLUMN user_plans.monthly_allowance IS NULL;
    COMMENT ON COLUMN user_plans.max_units_per_request IS NULL;
    COMMENT ON COLUMN account_monthly_usage.month IS NULL;
    COMMENT ON COLUMN user_monthly_usage.month IS NULL;
    COMMENT ON COLUMN user_monthly_usage.used_units IS NULL;
  `);
};
