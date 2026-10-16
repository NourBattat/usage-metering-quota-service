export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE accounts
      ALTER COLUMN account_plan_id SET NOT NULL;

    ALTER TABLE users
      ALTER COLUMN user_plan_id SET NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ALTER COLUMN user_plan_id DROP NOT NULL;

    ALTER TABLE accounts
      ALTER COLUMN account_plan_id DROP NOT NULL;
  `);
};
