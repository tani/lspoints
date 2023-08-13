import { PatchableObjectBox } from "./box.ts";
import { LanguageClient } from "./client.ts";
import { Lock } from "./deps/async.ts";
import { Denops } from "./deps/denops.ts";
import { Command, NotifyCallback, Settings } from "./interface.ts";
import { ArrayOrObject } from "./jsonrpc/message.ts";

const lock = new Lock(null);

export class Lspoints {
  commands: Record<string, Record<string, Command>> = {};
  notifiers: Record<string, Array<NotifyCallback>> = {};
  clients: Record<string, LanguageClient> = {};
  settings: PatchableObjectBox<Settings> = new PatchableObjectBox({
    clientCapabilites: {},
  });

  async start(
    denops: Denops,
    name: string,
    command: string[],
    options: Record<string, unknown> = {},
  ) {
    if (this.clients[name] == null) {
      await lock.lock(async () => {
        this.clients[name] = await new LanguageClient(denops, name, command)
          .initialize(options);
        // TODO: adhoc approachなので書き直す
        this.clients[name].rpcClient.notifiers.push(async (msg) => {
          await denops.call("luaeval", "require('lspoints').notify(_A)", msg)
            .catch(console.log);
        });
        this.clients[name].rpcClient.notifiers.push(async (msg) => {
          for (const notifier of this.notifiers[msg.method] ?? []) {
            await notifier(name, msg.params);
          }
        });
      });
    }
  }

  async attach(name: string, bufNr: number) {
    await lock.lock(async () => {
      const client = this.clients[name];
      if (client == null) {
        throw Error(`client "${name}" is not started`);
      }
      await client.attach(bufNr);
    });
  }

  async notifyChange(bufNr: number, changedtick: number) {
    const clients = Object.values(this.clients)
      .filter((client) => client.isAttached(bufNr));
    if (clients.length === 0) {
      return;
    }
    const denops = clients[0].denops;
    const text =
      (await denops.call("getbufline", bufNr, 1, "$") as string[]).join(
        "\n",
      ) + "\n";
    for (const client of clients) {
      client.notifyChange(bufNr, text, changedtick);
    }
  }

  getClients(bufNr: number) {
    return Object.entries(this.clients)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .filter((entry) => entry[1].isAttached(bufNr))
      .map((entry) => ({
        name: entry[0],
        serverCapabilities: entry[1].serverCapabilities,
      }));
  }

  async request(name: string, method: string, params: ArrayOrObject = {}) {
    if (lock.locked) {
      await lock.lock(() => {});
    }
    const client = this.clients[name];
    if (client == null) {
      throw Error(`client "${name}" is not started`);
    }
    return await client.rpcClient.request(method, params);
  }

  async loadExtensions(path: string[]) {
    // TODO: impl
    await lock.lock(async () => {
    });
  }

  subscribeNotify(
    method: string,
    callback: NotifyCallback,
  ) {
    (this.notifiers[method] = this.notifiers[method] ?? []).push(callback);
  }

  defineCommands(extensionName: string, commands: Record<string, Command>) {
    this.commands[extensionName] = commands;
  }

  async executeCommand(
    extensionName: string,
    command: string,
    ...args: unknown[]
  ): Promise<unknown> {
    return await this.commands[extensionName][command](...args);
  }
}

export const lspoints = new Lspoints();
