/** A task the entry says the author still has to do. The dates are the author's own words
 *  ("next friday", "by the 15th"), resolved against the jot's day by chrono: the model is
 *  never asked what today is, and never asked to do date arithmetic. */
export interface DetectedTask {
  description: string;
  start?: string;
  due?: string;
  type?: string;
}
