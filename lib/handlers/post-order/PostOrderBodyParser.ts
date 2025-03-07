import { Logger } from '@aws-lambda-powertools/logger'
import {
  CosignedPriorityOrder as SDKPriorityOrder,
  CosignedV2DutchOrder,
  CosignedV2DutchOrder as SDKV2DutchOrder,
  DutchOrder as SDKDutchOrder,
  OrderType,
  RelayOrder as SDKRelayOrder,
  RelayOrderParser,
  UniswapXOrderParser,
  CosignedV3DutchOrder,
  CosignedV3DutchOrder as SDKV3DutchOrder,
} from '@uniswap/uniswapx-sdk'
import { UnexpectedOrderTypeError } from '../../errors/UnexpectedOrderTypeError'
import { DutchV1Order } from '../../models/DutchV1Order'
import { DutchV2Order } from '../../models/DutchV2Order'
import { LimitOrder } from '../../models/LimitOrder'
import { Order } from '../../models/Order'
import { PriorityOrder } from '../../models/PriorityOrder'
import { RelayOrder } from '../../models/RelayOrder'
import { PostOrderRequestBody } from './schema'
import { DutchV3Order } from '../../models/DutchV3Order'
import { metrics } from '../../util/metrics'
import { Unit } from 'aws-embedded-metrics'
import { DUTCHV2_ORDER_LATENCY_THRESHOLD_SEC } from '../constants'
import { ChainId } from '../../util/chain'

export class PostOrderBodyParser {
  private readonly uniswapXParser = new UniswapXOrderParser()
  private readonly relayParser = new RelayOrderParser()

  constructor(private readonly logger: Logger) {}
  fromPostRequest(body: PostOrderRequestBody): Order {
    const { encodedOrder, signature, chainId, orderType } = body
    this.logger.info('Parsing order', { encodedOrder, signature, chainId, orderType })
    switch (orderType) {
      case OrderType.Dutch:
        return this.tryParseDutchV1Order(encodedOrder, signature, chainId, body.quoteId)
      case OrderType.Limit:
        return this.tryParseLimitOrder(encodedOrder, signature, chainId, body.quoteId)
      case OrderType.Dutch_V2:
        return this.tryParseDutchV2Order(encodedOrder, signature, chainId, body.quoteId, body.requestId)
      case OrderType.Dutch_V3:
        return this.tryParseDutchV3Order(encodedOrder, signature, chainId, body.quoteId, body.requestId)
      case OrderType.Relay:
        return this.tryParseRelayOrder(encodedOrder, signature, chainId)
      case OrderType.Priority:
        return this.tryParsePriorityOrder(encodedOrder, signature, chainId, body.quoteId, body.requestId)
      case undefined:
        // If an OrderType is not explicitly set, it is the legacy format which is either a DutchOrderV1 or a LimitOrder.
        // Try to parse both and see which hits.
        return this.tryParseDutchOrder(encodedOrder, signature, chainId, body.quoteId)
    }
  }

  private tryParseRelayOrder(encodedOrder: string, signature: string, chainId: number): RelayOrder {
    try {
      const order = this.relayParser.parseOrder(encodedOrder, chainId)
      const orderType = this.relayParser.getOrderType(order)
      if (orderType === OrderType.Relay) {
        return new RelayOrder(order as SDKRelayOrder, signature, chainId)
      }
      throw new UnexpectedOrderTypeError(orderType)
    } catch (err) {
      this.logger.error('Unable to parse Relay order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  private tryParseDutchV1Order(
    encodedOrder: string,
    signature: string,
    chainId: number,
    quoteId?: string
  ): DutchV1Order {
    try {
      const order = this.tryParseDutchOrder(encodedOrder, signature, chainId, quoteId)
      if (order.orderType === OrderType.Dutch) {
        return order
      }
      throw new UnexpectedOrderTypeError(order.orderType)
    } catch (err) {
      this.logger.error('Unable to parse DutchV1 order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  private tryParseDutchV2Order(
    encodedOrder: string,
    signature: string,
    chainId: number,
    quoteId?: string,
    requestId?: string
  ): DutchV2Order {
    try {
      const order = CosignedV2DutchOrder.parse(encodedOrder, chainId)
      // Log the decay start time difference for debugging
      const decayStartTime = order.info.cosignerData.decayStartTime
      const currentTime = Math.floor(Date.now() / 1000) // Convert to seconds
      const timeDifference = Number(decayStartTime) - currentTime

      // GPA currentlys sets mainnet decay start to 24 secs into the future
      if (chainId == ChainId.MAINNET && timeDifference > DUTCHV2_ORDER_LATENCY_THRESHOLD_SEC) {
        const staleOrderMetricName = `StaleOrder-chain-${chainId.toString()}`
        metrics.putMetric(staleOrderMetricName, 1, Unit.Count)
      }
      const staleOrderMetricName = `OrderStaleness-chain-${chainId.toString()}`
      metrics.putMetric(staleOrderMetricName, timeDifference)

      return new DutchV2Order(order as SDKV2DutchOrder, signature, chainId, undefined, undefined, quoteId, requestId)
    } catch (err) {
      this.logger.error('Unable to parse DutchV2 order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  private tryParseDutchV3Order(
    encodedOrder: string,
    signature: string,
    chainId: number,
    quoteId?: string,
    requestId?: string
  ): DutchV3Order {
    try {
      const order = CosignedV3DutchOrder.parse(encodedOrder, chainId)
      return new DutchV3Order(order as SDKV3DutchOrder, signature, chainId, undefined, undefined, undefined, quoteId, requestId)
    } catch (err) {
      this.logger.error('Unable to parse DutchV3 order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  private tryParsePriorityOrder(
    encodedOrder: string,
    signature: string,
    chainId: number,
    quoteId?: string,
    requestId?: string
  ): PriorityOrder {
    try {
      const order = SDKPriorityOrder.parse(encodedOrder, chainId)
      return new PriorityOrder(order, signature, chainId, undefined, undefined, quoteId, requestId)
    } catch (err) {
      this.logger.error('Unable to parse Priority order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  private tryParseLimitOrder(encodedOrder: string, signature: string, chainId: number, quoteId?: string): LimitOrder {
    try {
      const order = this.tryParseDutchOrder(encodedOrder, signature, chainId, quoteId)
      if (order.orderType === OrderType.Limit) {
        return order
      }
      throw new UnexpectedOrderTypeError(order.orderType)
    } catch (err) {
      this.logger.error('Unable to parse Limit order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }

  tryParseDutchOrder(encodedOrder: string, signature: string, chainId: number, quoteId?: string) {
    try {
      const order = this.uniswapXParser.parseOrder(encodedOrder, chainId)
      const orderType = this.uniswapXParser.getOrderType(order)
      if (orderType === OrderType.Limit) {
        return new LimitOrder(order as SDKDutchOrder, signature, chainId, quoteId)
      } else if (orderType === OrderType.Dutch) {
        return new DutchV1Order(order as SDKDutchOrder, signature, chainId, quoteId)
      } else {
        throw new UnexpectedOrderTypeError(orderType)
      }
    } catch (err) {
      this.logger.error('Unable to parse legacy Dutch order', {
        err,
        encodedOrder,
        chainId,
        signature,
      })
      throw err
    }
  }
}
