import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import worker from './dist/server/index.js';
mkdirSync('.sites-runtime',{recursive:true});
const sqlite=new DatabaseSync('.sites-runtime/local.sqlite');
sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
const migrationName='0000_early_captain_stacy.sql';
if(!sqlite.prepare('SELECT name FROM local_migrations WHERE name = ?').get(migrationName)){sqlite.exec(readFileSync(`drizzle/${migrationName}`,'utf8'));sqlite.prepare('INSERT INTO local_migrations (name) VALUES (?)').run(migrationName);}
const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return sqlite.prepare(sql).get(...this.args)||null;},async all(){return {results:sqlite.prepare(sql).all(...this.args)};},async run(){return sqlite.prepare(sql).run(...this.args);}};}};
createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);const result=await worker.fetch(new Request(`http://localhost:3000${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body})}),{DB,AI_API_KEY:process.env.AI_API_KEY,AI_BASE_URL:process.env.AI_BASE_URL,AI_MODEL:process.env.AI_MODEL});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch(e){res.writeHead(500);res.end('Local server error');console.error(e.message);}}).listen(3000,'127.0.0.1',()=>console.log('Local: http://localhost:3000'));
