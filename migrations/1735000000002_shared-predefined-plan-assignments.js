export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE accounts
      DROP CONSTRAINT accounts_plan_pair_check,
      ADD CONSTRAINT accounts_plan_pair_check CHECK (
        account_plan_id IS NOT NULL OR account_plan_owner_account_id IS NULL
      );

    ALTER TABLE users
      DROP CONSTRAINT users_plan_pair_check,
      ADD CONSTRAINT users_plan_pair_check CHECK (
        user_plan_id IS NOT NULL OR user_plan_owner_account_id IS NULL
      );

    CREATE OR REPLACE FUNCTION enforce_account_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
      plan_is_predefined boolean;
    BEGIN
      IF NEW.account_plan_id IS NULL THEN
        IF NEW.account_plan_owner_account_id IS NOT NULL THEN
          RAISE EXCEPTION 'An account plan owner cannot be set without a plan'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      SELECT owner_account_id, is_predefined
      INTO plan_owner, plan_is_predefined
      FROM account_plans
      WHERE id = NEW.account_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Account plan % does not exist', NEW.account_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_is_predefined AND plan_owner IS NOT NULL THEN
        RAISE EXCEPTION 'Predefined account plans must not have an owner account'
          USING ERRCODE = '23514';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.id THEN
        RAISE EXCEPTION 'Custom account plans can only be assigned to their owner'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.account_plan_owner_account_id IS NOT NULL
        AND NEW.account_plan_owner_account_id IS DISTINCT FROM plan_owner THEN
        RAISE EXCEPTION 'Account plan owner does not match the selected plan'
          USING ERRCODE = '23514';
      END IF;

      NEW.account_plan_owner_account_id := plan_owner;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER accounts_plan_ownership_trigger ON accounts;
    CREATE TRIGGER accounts_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF account_plan_id, account_plan_owner_account_id ON accounts
      FOR EACH ROW EXECUTE FUNCTION enforce_account_plan_ownership();

    CREATE OR REPLACE FUNCTION enforce_user_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
      plan_is_predefined boolean;
    BEGIN
      IF NEW.user_plan_id IS NULL THEN
        IF NEW.user_plan_owner_account_id IS NOT NULL THEN
          RAISE EXCEPTION 'A user plan owner cannot be set without a plan'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      SELECT owner_account_id, is_predefined
      INTO plan_owner, plan_is_predefined
      FROM user_plans
      WHERE id = NEW.user_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'User plan % does not exist', NEW.user_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_is_predefined AND plan_owner IS NOT NULL THEN
        RAISE EXCEPTION 'Predefined user plans must not have an owner account'
          USING ERRCODE = '23514';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.account_id THEN
        RAISE EXCEPTION 'Custom user plans can only be assigned within their owner account'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.user_plan_owner_account_id IS NOT NULL
        AND NEW.user_plan_owner_account_id IS DISTINCT FROM plan_owner THEN
        RAISE EXCEPTION 'User plan owner does not match the selected plan'
          USING ERRCODE = '23514';
      END IF;

      NEW.user_plan_owner_account_id := plan_owner;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER users_plan_ownership_trigger ON users;
    CREATE TRIGGER users_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF user_plan_id, user_plan_owner_account_id, account_id ON users
      FOR EACH ROW EXECUTE FUNCTION enforce_user_plan_ownership();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS users_plan_ownership_trigger ON users;
    CREATE TRIGGER users_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF user_plan_id, account_id ON users
      FOR EACH ROW EXECUTE FUNCTION enforce_user_plan_ownership();

    DROP TRIGGER IF EXISTS accounts_plan_ownership_trigger ON accounts;
    CREATE TRIGGER accounts_plan_ownership_trigger
      BEFORE INSERT OR UPDATE OF account_plan_id ON accounts
      FOR EACH ROW EXECUTE FUNCTION enforce_account_plan_ownership();

    CREATE OR REPLACE FUNCTION enforce_user_plan_ownership() RETURNS trigger
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

    CREATE OR REPLACE FUNCTION enforce_account_plan_ownership() RETURNS trigger
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

    ALTER TABLE users
      DROP CONSTRAINT users_plan_pair_check,
      ADD CONSTRAINT users_plan_pair_check CHECK (
        (user_plan_id IS NULL) = (user_plan_owner_account_id IS NULL)
      );

    ALTER TABLE accounts
      DROP CONSTRAINT accounts_plan_pair_check,
      ADD CONSTRAINT accounts_plan_pair_check CHECK (
        (account_plan_id IS NULL) = (account_plan_owner_account_id IS NULL)
      );
  `);
};
