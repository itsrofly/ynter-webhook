### Update env & upload function
```bash
$ supabase secrets set --env-file .env
$ supabase functions deploy --no-verify-jwt function_name
$ supabase snippets download 60319b60-36b8-4aee-b301-e58e19e3f022 > start.sql
```