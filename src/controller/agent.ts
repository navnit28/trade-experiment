import axios from "axios";
import type { Request, Response } from "express";
import { normalizeTrading80Call } from "../utils/trading80.mapper.js";
import { Trading80Call } from "../Models/trading80.model.js";
import client from "../config/mongoClient.js";

async function fetchCallAlerts(sessionCookie: string) {
  try {
     const response = await axios.post(
    "https://frapi.trading80.com/callsapi/getCallAlerts",
    {},
    {
      headers: {
        Cookie: `session_cookie=${sessionCookie}`,
      },
      timeout: 10000,
    }
  );
  return response.data;
  } catch (error) {
    console.log("Getting error in fetching cal Alerts",error);
  }
}

const findInstrument = async (collection:any, stockName:string, segment:string) => {
  // 1. exact trading symbol
  let matches = await collection.find({
    trading_symbol: { $regex: new RegExp(`^${stockName}$`, "i") },
    segment,
  }).toArray();

  if (matches.length === 1) return matches[0];

  // 2. short_name
  matches = await collection.find({
    short_name: { $regex: new RegExp(stockName, "i") },
    segment,
  }).toArray();

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { multiple: matches };

  // 3. name fallback
  matches = await collection.find({
    name: { $regex: new RegExp(stockName, "i") },
    segment,
  }).toArray();

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { multiple: matches };

  return null;
};


export const Agent = {
  fetch: async (req: Request, res: Response) => {
  try {
    // const status = req.query.status as string || "ACTIVE";

    // const query: any = {};
    // if (status) query.tradeStatus = status;
    const calls = await Trading80Call.find()
    .sort({ createdAtTrading80: -1 })
    .lean();
    
    console.log("fetchings calls",calls);
    res.json({
      success: true,
      count: calls.length,
      data: calls,
    });
  } catch (error) {
    console.error("Fetch failed:", error);
    res.status(500).json({ error: "Failed to fetch calls" });
  }
},

  syncCalls:async(req:Request,res:Response)=>{
    try {
      const sessionCookie =process.env.session_cookie;
      if (!sessionCookie) {
        return res.status(400).json({ error: "session_cookie required" });
      }

      const data = await fetchCallAlerts(sessionCookie);
      console.log("data",data.data)
      const activeCalls = data?.data?.new ?? [];
      const changes = data?.data?.changes ?? [];


    const currCalls=await Trading80Call.find();

    await client.connect();
    const db= client.db("test");
    const collection = db.collection("stocks");
    

    console.log("active calls",activeCalls);
    console.log("changes",changes)
    
    for (const call of activeCalls){
       let matchedInstrument = await findInstrument(collection, call.sname, "NSE_EQ");
      let exchange = "NSE";

      if (!matchedInstrument) {
        matchedInstrument = await findInstrument(collection, call.sname, "BSE_EQ");
        exchange = "BSE";
      }

      if (matchedInstrument?.multiple) {
        continue;
      }

      if (!matchedInstrument) {
        continue;
      }
      const instrument_token = matchedInstrument.instrument_key;
      const activeExternalIds = new Set<number>();
      const normalized = normalizeTrading80Call(call);
      activeExternalIds.add(normalized.stockId);
      
      await Trading80Call.findOneAndUpdate(
        { stockId: normalized.stockId },
        {
          $set: {
            ...normalized,
            tradeStatus: "ACTIVE",
            instrument_token,
            lastSyncedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
    for(const call of changes){
      let matchedInstrument = await findInstrument(collection, call.sname, "NSE_EQ");
      let exchange = "NSE";

      if (!matchedInstrument) {
        matchedInstrument = await findInstrument(collection, call.sname, "BSE_EQ");
        exchange = "BSE";
      }

      if (matchedInstrument?.multiple) {
        continue;
      }

      if (!matchedInstrument) {
        continue;
      }
      const instrument_token = matchedInstrument.instrument_key;
      
      const isInCurrCalls=currCalls.find((item)=>item.instrument_token === instrument_token);

      let tradeStatus;
      console.log("call reason",call.reason,call.sname);
      if (call.reason === "TARGET HIT") {
        tradeStatus = "TARGET_HIT";
      } else if (call.reason === "STOP LOSS HIT") {
        tradeStatus = "STOP_LOSS_HIT";
      } else if (call.reason === "REVERSED") {
        tradeStatus = "REVERSED";
      } else {
        tradeStatus = "UNKNOWN";
      }

      if(isInCurrCalls){
          await Trading80Call.findOneAndUpdate(
                { stockId: call.stockid },
                {
                  $set: {
                    tradeStatus:tradeStatus,
                    instrument_token,
                    lastSyncedAt: new Date(),
                  },
                }
              );
      } else {
        const normalized = normalizeTrading80Call(call);
        await Trading80Call.findOneAndUpdate(
          { stockId: call.stockid },
          {
            $set: {
              ...normalized,
              tradeStatus:tradeStatus,
              instrument_token,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
    
  }
    return res.json({message:"Data synced successfully"});
   } catch (error) {
     console.log("errror in upserting the data",error);
   }
}

};
