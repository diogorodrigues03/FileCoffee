import { ServerMessage, ServerMessageType } from "@/constants/enums";

export abstract class BaseStrategy<TContext> {
  abstract handle(message: ServerMessage, context: TContext): Promise<void> | void;
}

export class StrategyManager<TContext> {
  private strategies: Partial<Record<ServerMessageType, BaseStrategy<TContext>>> = {};

  register(type: ServerMessageType, strategy: BaseStrategy<TContext>) {
    this.strategies[type] = strategy;
  }

  async handleMessage(message: ServerMessage, context: TContext) {
    const strategy = this.strategies[message.type];
    if (strategy) {
      await strategy.handle(message, context);
    } else {
      console.warn(`No strategy found for message type: ${message.type}`);
    }
  }
}
