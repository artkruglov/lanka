import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
const root=resolve(import.meta.dirname,".."),folder=join(homedir(),"Library/LaunchAgents");
const path=join(folder,"local.lanka-studio.web.plist");
const escape=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
let previous="";
try {
  previous=await readFile(path,"utf8");
  if(!previous.includes(`<string>${escape(root)}</string>`))throw new Error("The existing Lanka service belongs to a different checkout; leave it unchanged.");
}catch(e){if(e.code!=="ENOENT")throw e;}
if(process.argv.includes("--remove")) {
  await unlink(path).catch(e=>{if(e.code!=="ENOENT")throw e;});
  process.exit(0);
}
const requestedUi=process.env.LANKA_UI_REFRESH;
if(requestedUi!==undefined&&!["0","1"].includes(requestedUi))throw new Error("LANKA_UI_REFRESH must be 0 or 1.");
const savedUi=previous.match(/<key>LANKA_UI_REFRESH<\/key>\s*<string>([01])<\/string>/)?.[1]??"0";
const uiRefresh=requestedUi??savedUi;
await mkdir(folder,{recursive:true});
const strings=values=>values.map(v=>`<string>${escape(v)}</string>`).join("");
await writeFile(path,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.lanka-studio.web</string>
<key>ProgramArguments</key><array>${strings(["/bin/bash",join(root,"scripts/run-local-service.sh"),process.execPath])}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>LANKA_UI_REFRESH</key><string>${uiRefresh}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${escape(join(root,"work/local-server/stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escape(join(root,"work/local-server/stderr.log"))}</string>
</dict></plist>\n`,{mode:0o600});
