### Update env & upload function
```bash
$ supabase secrets set --env-file .env
$ supabase functions deploy --no-verify-jwt function_name
```

### PostgreSQL
```SQL
CREATE TABLE IF NOT EXISTS
  accounts (
    id uuid not null primary key unique references auth.users on delete cascade,
    email VARCHAR(255) unique not null,
    customer_id VARCHAR(255) unique,
    locale VARCHAR(255),
    Created TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
alter table "accounts" enable row level security;

CREATE TABLE IF NOT EXISTS
  subscriptions (
    subscription_id VARCHAR(255) not null primary key unique,
    customer_id VARCHAR(255) not null,
    input_token INT not null,
    cancel_at_period_end INT DEFAULT 0,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires TIMESTAMP WITHOUT TIME ZONE,
    FOREIGN KEY (customer_id) REFERENCES accounts (customer_id) ON DELETE CASCADE
  );
alter table "subscriptions" enable row level security;

CREATE TABLE IF NOT EXISTS
  payments (
    charge_id VARCHAR(255) not null primary key unique,
    subscription_id VARCHAR(255) not null,
    customer_id VARCHAR(255) not null,
    amount NUMERIC(10, 2) not null,
    currency VARCHAR(255) not null,
    country VARCHAR(255),
    customer_email VARCHAR(255),
    customer_name VARCHAR(255),
    returned INT DEFAULT 0,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES accounts (customer_id) ON DELETE CASCADE
  );
  alter table "payments" enable row level security;

  CREATE TABLE IF NOT EXISTS tokens (
    tokens_id VARCHAR(255) not null primary key unique,
    customer_id VARCHAR(255) NOT NULL,
    access_token VARCHAR(255) NOT NULL,
    institution_id VARCHAR(255) NOT NULL,
    created TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES accounts (customer_id) ON DELETE CASCADE,
    UNIQUE (customer_id, institution_id)
);
  alter table "tokens" enable row level security;
  
-- create user, database
create
or replace function public.handle_new_user () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into public.accounts (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

-- trigger the function every time a user is created
create
or replace trigger on_auth_user_created
after insert on auth.users for each row
execute procedure public.handle_new_user ();
```