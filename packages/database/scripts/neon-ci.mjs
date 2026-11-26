// Fresh database per run: schema-only branches may contain migration tables without their history.
import pg from 'pg';
import {execFileSync} from 'node:child_process';
const url = new URL(process.env.DATABASE_URL);
const name = `lab_ci_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}`;
if (!/^lab_ci_\d+_\d+$/.test(name)) throw new Error('CI run IDs required');
const admin = new pg.Client({connectionString:url.toString()});
await admin.connect();
let created=false;
try {
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created=true;
  url.pathname=`/${name}`;
  const env={...process.env,DATABASE_URL:url.toString(),TEST_DATABASE_URL:url.toString()};
  execFileSync('pnpm',['--filter','@lab/database','migrate'],{env,stdio:'inherit'});
  execFileSync('pnpm',['--filter','@lab/control-plane','test'],{env,stdio:'inherit'});
} finally {
  try { if(created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
  finally { await admin.end(); }
}
