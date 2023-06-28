export type Config = {
  privateKey: string;
  botPubkeys: string[];
  timeoutSec: number;
  relay: {
    write: string[];
    read: string[];
  };
  profile: {
    name: string;
    display_name: string;
    about: string;
    [key: string]: string;
  };
};
