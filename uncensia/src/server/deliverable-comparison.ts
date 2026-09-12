import fs from "node:fs";
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import type { Store } from "./store/store.ts";
import type { DeliverableComparison, DeliverableRecord } from "@shared/evidence.ts";

export function compareDeliverables(store: Store, conversationId: string, key: string, from: number, to: number): DeliverableComparison {
  const version = (revision: number) => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Choose valid version numbers");
    const row = store.db.get<{data:string}>("SELECT data FROM deliverable_versions WHERE conversation_id=? AND key=? AND revision=?",conversationId,key,revision);
    if (!row) throw new Error("Deliverable version not found");
    const item = JSON.parse(row.data) as DeliverableRecord;
    const file = item.asset_id ? store.getFile(item.asset_id) : undefined;
    if (!file) throw new Error("This version has no available file");
    return {item,file};
  };
  const left = version(from), right = version(to);
  const result = {from:left.item,to:right.item};
  if ([left,right].some(({file})=>!file.mime.startsWith("text/") && file.mime !== "application/json")) return {...result,kind:"preview",reason:"format"};
  if ([left,right].some(({file})=>file.bytes > 256_000)) return {...result,kind:"preview",reason:"size"};
  const read = ({item,file}: typeof left) => {
    const bytes = fs.readFileSync(file.diskPath);
    if (createHash("sha256").update(bytes).digest("hex") !== item.asset_version) throw new Error("Version file changed; comparison is unavailable");
    return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  };
  const patch = createTwoFilesPatch(`revision-${from}`,`revision-${to}`,read(left),read(right),"","",{context:3,timeout:40,maxEditLength:4000});
  if (patch === undefined || patch.length > 256_000) return {...result,kind:"preview",reason:"size"};
  return {...result,kind:"text",patch};
}
