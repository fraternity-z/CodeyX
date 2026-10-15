export type RemoteStatus = {
  running: boolean;
  address?: string;
  urls: string[];
  tunnel?: { status: string; message: string };
  devices: { id: string; name: string }[];
};

export type Pairing = { url: string; qrCode: string; expiresIn: number };
export type ConnectionMode = "tunnel" | "lan" | "custom";
export type RemoteDraft = { bindAddress: string; port: string; publicUrl: string; connection: ConnectionMode };
export type RemoteSnapshot = { status: RemoteStatus; url: string; pairing: Pairing | null };
