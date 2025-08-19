export type RunOptions = {
  /**
   * The name of the function. By default, if you pass in api.foo.bar.baz,
   * it will use "foo/bar:baz" as the name. If you pass in a function handle,
   * it will use the function handle directly.
   */
  name?: string;
} & SchedulerOptions;

export type SchedulerOptions =
  | {
      /**
       * The time (ms since epoch) to run the action at.
       * If not provided, the action will be run as soon as possible.
       * Note: this is advisory only. It may run later.
       */
      runAt?: number;
    }
  | {
      /**
       * The number of milliseconds to run the action after.
       * If not provided, the action will be run as soon as possible.
       * Note: this is advisory only. It may run later.
       */
      runAfter?: number;
    };
