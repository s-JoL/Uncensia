export interface DeliverableInput {
  key: string;
  description: string;
  status: "pending" | "produced" | "verified";
  asset_id?: string;
  evidence?: string;
}
export interface DeliverableRecord extends DeliverableInput {
  revision: number;
  source_asset_id?: string;
  asset_version?: string;
  review?: { status: "accepted" | "rejected"; at: number };
}
export type DeliverableComparison = {from:DeliverableRecord;to:DeliverableRecord} & (
  {kind:"text";patch:string} | {kind:"preview";reason:"format"|"size"}
);
export interface ConversationEvidence {
  deliverables: DeliverableRecord[];
  feedback: Array<{ entry_id: string; text: string }>;
  contexts: Array<{
    id: number; runId: string; modelId: string; modelInput: string[]; tools: string[];
    requestIndex?: number; phase?: "prepared"; payloadHash?: string; schemaHash?: string;
    project?: {id:string;revision:number} | null;
    textCharacters?: number; messageCount?: number; embeddedImages?: number; remoteImages?: number;
  }>;
}
