# Predefined Plan Defaults

The following values are project assumptions for the Usage Metering and Quota Service demonstration. They are not official Boot.dev limits or recommendations.

| Plan type | Name | Monthly allowance (units) | Maximum units per request |
| --- | --- | ---: | ---: |
| Account | Starter | 10,000 | 100 |
| Account | Pro | 100,000 | 1,000 |
| User | Basic | 1,000 | 20 |
| User | Premium | 5,000 | 100 |

Account plans apply to the combined usage of an account and all of its users. User plans provide a separate allowance for each individual user. The plan definitions live in separate tables and each predefined plan has `owner_account_id = NULL` and `is_predefined = true`.

Run `npm run seed` to insert missing predefined plans. Repeating the command does not create duplicates or change matching definitions. If a predefined plan name already exists with different limits, seeding stops with an error rather than silently overwriting it. Account-owned custom plans are not modified by seeding.
