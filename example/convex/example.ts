import { v } from "convex/values";
import { WorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";

export const workflow = new WorkflowManager(components.workflow);

export const exampleWorkflow = workflow.define({
  args: {
    location: v.string(),
  },
  handler: async (
    step,
    args,
    // When returning things from other functions, you need to break the type
    // inference cycle by specifying the return type explicitly.
  ): Promise<{
    name: string;
    celsius: number;
    farenheit: number;
    windSpeed: number;
    windGust: number;
  }> => {
    console.time("overall");
    console.time("geocoding");
    // Run in parallel!
    const [{ latitude, longitude, name }, weather2] = await Promise.all([
      step.runAction(internal.example.getGeocoding, args, { runAfter: 100 }),
      step.runAction(internal.example.getGeocoding, args, { retry: true }),
    ]);
    console.log("Is geocoding is consistent?", latitude === weather2.latitude);
    console.timeLog("geocoding", name);
    console.time("weather");
    const weather = await step.runAction(internal.example.getWeather, {
      latitude,
      longitude,
    });
    const celsius = weather.temperature;
    const farenheit = (celsius * 9) / 5 + 32;
    const { temperature, windSpeed, windGust } = weather;
    console.log(
      `Weather in ${name}: ${farenheit.toFixed(1)}°F (${temperature}°C), ${windSpeed} km/h, ${windGust} km/h`,
    );
    console.timeLog("weather", temperature);
    await step.runMutation(internal.example.updateFlow, {
      workflowId: step.workflowId,
      out: { name, celsius, farenheit, windSpeed, windGust },
    });
    console.timeEnd("overall");
    return { name, celsius, farenheit, windSpeed, windGust };
  },
  workpoolOptions: {
    retryActionsByDefault: true,
  },
  // If you also want to run runtime validation on the return value.
  returns: v.object({
    name: v.string(),
    celsius: v.number(),
    farenheit: v.number(),
    windSpeed: v.number(),
    windGust: v.number(),
  }),
});

export const startWorkflow = internalMutation({
  args: {
    location: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const location = args.location ?? "San Francisco";
    const id: WorkflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { location },
      {
        onComplete: internal.example.flowCompleted,
        context: { location },
        startAsync: true,
      },
    );
    await ctx.db.insert("flows", { workflowId: id, in: location, out: null });
    return id;
  },
});

export const cancelWorkflow = internalMutation({
  args: {
    workflowId: vWorkflowId,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await workflow.cancel(ctx, args.workflowId);
  },
});

export const flowCompleted = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) {
      console.error(`Flow not found: ${args.workflowId}`);
      return;
    }
    await ctx.db.patch(flow._id, {
      out: args.result,
    });
    // To delete the workflow data after it completes:
    // await workflow.cleanup(ctx, args.workflowId);
  },
});

export const getGeocoding = internalAction({
  args: {
    location: v.string(),
  },
  returns: v.object({
    latitude: v.number(),
    longitude: v.number(),
    name: v.string(),
  }),
  handler: async (_ctx, { location }) => {
    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = (await geocodingResponse.json()) as {
      results: {
        latitude: number;
        longitude: number;
        name: string;
      }[];
    };

    if (!geocodingData.results?.[0]) {
      throw new Error(`Location '${location}' not found`);
    }

    const { latitude, longitude, name } = geocodingData.results[0];
    return { latitude, longitude, name };
  },
});

export const getWeather = internalAction({
  args: {
    latitude: v.number(),
    longitude: v.number(),
  },
  returns: v.object({
    temperature: v.number(),
    windSpeed: v.number(),
    windGust: v.number(),
  }),
  handler: async (_ctx, { latitude, longitude }) => {
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code`;

    const response = await fetch(weatherUrl);
    const data = (await response.json()) as {
      current: {
        time: string;
        temperature_2m: number;
        wind_speed_10m: number;
        wind_gusts_10m: number;
      };
    };
    return {
      temperature: data.current.temperature_2m,
      windSpeed: data.current.wind_speed_10m,
      windGust: data.current.wind_gusts_10m,
    };
  },
});

export const updateFlow = internalMutation({
  args: {
    workflowId: vWorkflowId,
    out: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) {
      throw new Error(`Flow not found: ${args.workflowId}`);
    }
    await ctx.db.patch(flow._id, {
      out: args.out,
    });
  },
});
