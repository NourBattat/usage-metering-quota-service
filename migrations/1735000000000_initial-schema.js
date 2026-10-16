export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
      api_key_hash text NOT NULL UNIQUE
        CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE account_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
      monthly_allowance bigint NOT NULL
        CHECK (monthly_allowance BETWEEN 0 AND 9000000000000000),
      max_units_per_request bigint NOT NULL
        CHECK (max_units_per_request BETWEEN 1 AND 1000000),
      is_predefined boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT account_plans_id_owner_unique UNIQUE (id, owner_account_id),
      CONSTRAINT account_plans_scope_check CHECK (
        (owner_account_id IS NULL AND is_predefined)
        OR (owner_account_id IS NOT NULL AND NOT is_predefined)
      )
    );
    CREATE UNIQUE INDEX account_plans_custom_name_unique
      ON account_plans (owner_account_id, name)
      WHERE owner_account_id IS NOT NULL;
    CREATE UNIQUE INDEX account_plans_predefined_name_unique
      ON account_plans (name)
      WHERE owner_account_id IS NULL;

    CREATE TABLE user_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
      monthly_allowance bigint NOT NULL
        CHECK (monthly_allowance BETWEEN 0 AND 9000000000000000),
      max_units_per_request bigint NOT NULL
        CHECK (max_units_per_request BETWEEN 1 AND 1000000),
      is_predefined boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_plans_id_owner_unique UNIQUE (id, owner_account_id),
      CONSTRAINT user_plans_scope_check CHECK (
        (owner_account_id IS NULL AND is_predefined)
        OR (owner_account_id IS NOT NULL AND NOT is_predefined)
      )
    );
    CREATE UNIQUE INDEX user_plans_custom_name_unique
      ON user_plans (owner_account_id, name)
      WHERE owner_account_id IS NOT NULL;
    CREATE UNIQUE INDEX user_plans_predefined_name_unique
      ON user_plans (name)
      WHERE owner_account_id IS NULL;

    ALTER TABLE accounts
      ADD COLUMN account_plan_id uuid,
      ADD COLUMN account_plan_owner_account_id uuid,
      ADD CONSTRAINT accounts_plan_pair_check CHECK (
        (account_plan_id IS NULL) = (account_plan_owner_account_id IS NULL)
      ),
      ADD CONSTRAINT accounts_plan_owner_check CHECK (
        account_plan_owner_account_id IS NULL
        OR account_plan_owner_account_id = id
      ),
      ADD CONSTRAINT accounts_plan_id_fk FOREIGN KEY (account_plan_id)
        REFERENCES account_plans(id) ON DELETE RESTRICT,
      ADD CONSTRAINT accounts_plan_scope_fk FOREIGN KEY (
        account_plan_id, account_plan_owner_account_id
      ) REFERENCES account_plans(id, owner_account_id) ON DELETE RESTRICT;
    CREATE INDEX accounts_plan_id_idx ON accounts (account_plan_id);

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
      user_plan_id uuid,
      user_plan_owner_account_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_id_account_unique UNIQUE (id, account_id),
      CONSTRAINT users_plan_pair_check CHECK (
        (user_plan_id IS NULL) = (user_plan_owner_account_id IS NULL)
      ),
      CONSTRAINT users_plan_owner_check CHECK (
        user_plan_owner_account_id IS NULL
        OR user_plan_owner_account_id = account_id
      ),
      CONSTRAINT users_plan_id_fk FOREIGN KEY (user_plan_id)
        REFERENCES user_plans(id) ON DELETE RESTRICT,
      CONSTRAINT users_plan_scope_fk FOREIGN KEY (
        user_plan_id, user_plan_owner_account_id
      ) REFERENCES user_plans(id, owner_account_id) ON DELETE RESTRICT
    );
    CREATE INDEX users_account_id_idx ON users (account_id);
    CREATE INDEX users_plan_id_idx ON users (user_plan_id);

    CREATE FUNCTION enforce_account_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
    BEGIN
      IF NEW.account_plan_id IS NULL THEN
        NEW.account_plan_owner_account_id := NULL;
        RETURN NEW;
      END IF;

      SELECT owner_account_id INTO plan_owner
      FROM account_plans WHERE id = NEW.account_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Account plan % does not exist', NEW.account_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.id THEN
        RAISE EXCEPTION 'Custom account plans can only be assigned to their owner'
          USING ERRCODE = '23514';
      END IF;

      NEW.account_plan_owner_account_id := plan_owner;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER accounts_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF account_plan_id ON accounts
      FOR EACH ROW EXECUTE FUNCTION enforce_account_plan_ownership();

    CREATE FUNCTION enforce_user_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
    BEGIN
      IF NEW.user_plan_id IS NULL THEN
        NEW.user_plan_owner_account_id := NULL;
        RETURN NEW;
      END IF;

      SELECT owner_account_id INTO plan_owner
      FROM user_plans WHERE id = NEW.user_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'User plan % does not exist', NEW.user_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.account_id THEN
        RAISE EXCEPTION 'Custom user plans can only be assigned within their owner account'
          USING ERRCODE = '23514';
      END IF;

      NEW.user_plan_owner_account_id := plan_owner;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER users_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF user_plan_id, account_id ON users
      FOR EACH ROW EXECUTE FUNCTION enforce_user_plan_ownership();

    CREATE TABLE account_monthly_usage (
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      month date NOT NULL CHECK (
        month = date_trunc('month', month::timestamp)::date
      ),
      used_units bigint NOT NULL DEFAULT 0
        CHECK (used_units BETWEEN 0 AND 9000000000000000),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, month)
    );

    CREATE TABLE user_monthly_usage (
      account_id uuid NOT NULL,
      user_id uuid NOT NULL,
      month date NOT NULL CHECK (
        month = date_trunc('month', month::timestamp)::date
      ),
      used_units bigint NOT NULL DEFAULT 0
        CHECK (used_units BETWEEN 0 AND 9000000000000000),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, user_id, month),
      CONSTRAINT user_monthly_usage_user_account_fk FOREIGN KEY (
        user_id, account_id
      ) REFERENCES users(id, account_id) ON DELETE CASCADE
    );
    CREATE INDEX user_monthly_usage_user_month_idx
      ON user_monthly_usage (user_id, month);

    CREATE TABLE consumption_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      request_id text NOT NULL
        CHECK (length(request_id) BETWEEN 1 AND 200),
      user_id uuid NOT NULL,
      units bigint NOT NULL CHECK (units BETWEEN 1 AND 1000000),
      status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
      rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(rejection_reasons) = 'array'),
      failed_rule_levels text[] NOT NULL DEFAULT ARRAY[]::text[]
        CHECK (failed_rule_levels <@ ARRAY['account', 'user']::text[]),
      account_plan_id uuid NOT NULL,
      account_plan_name text NOT NULL,
      account_monthly_allowance bigint NOT NULL
        CHECK (account_monthly_allowance BETWEEN 0 AND 9000000000000000),
      account_max_units_per_request bigint NOT NULL
        CHECK (account_max_units_per_request BETWEEN 1 AND 1000000),
      user_plan_id uuid NOT NULL,
      user_plan_name text NOT NULL,
      user_monthly_allowance bigint NOT NULL
        CHECK (user_monthly_allowance BETWEEN 0 AND 9000000000000000),
      user_max_units_per_request bigint NOT NULL
        CHECK (user_max_units_per_request BETWEEN 1 AND 1000000),
      response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
      response_body jsonb NOT NULL
        CHECK (jsonb_typeof(response_body) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT consumption_requests_account_request_unique
        UNIQUE (account_id, request_id),
      CONSTRAINT consumption_requests_user_account_fk FOREIGN KEY (
        user_id, account_id
      ) REFERENCES users(id, account_id) ON DELETE CASCADE,
      CONSTRAINT consumption_requests_status_response_check CHECK (
        (status = 'accepted' AND response_status BETWEEN 200 AND 299)
        OR (status = 'rejected' AND response_status BETWEEN 400 AND 599)
      )
    );
    CREATE INDEX consumption_requests_account_history_idx
      ON consumption_requests (account_id, created_at DESC, id DESC);
    CREATE INDEX consumption_requests_user_history_idx
      ON consumption_requests (account_id, user_id, created_at DESC, id DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS consumption_requests;
    DROP TABLE IF EXISTS user_monthly_usage;
    DROP TABLE IF EXISTS account_monthly_usage;
    DROP TABLE IF EXISTS users;
    DROP FUNCTION IF EXISTS enforce_user_plan_ownership();
    DROP FUNCTION IF EXISTS enforce_account_plan_ownership();
    ALTER TABLE IF EXISTS accounts
      DROP CONSTRAINT IF EXISTS accounts_plan_scope_fk,
      DROP CONSTRAINT IF EXISTS accounts_plan_id_fk,
      DROP CONSTRAINT IF EXISTS accounts_plan_owner_check,
      DROP CONSTRAINT IF EXISTS accounts_plan_pair_check,
      DROP COLUMN IF EXISTS account_plan_owner_account_id,
      DROP COLUMN IF EXISTS account_plan_id;
    DROP TABLE IF EXISTS user_plans;
    DROP TABLE IF EXISTS account_plans;
    DROP TABLE IF EXISTS accounts;
  `);
};
