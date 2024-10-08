import { calculateAvgBurnRate } from "@/utils/format";
import { getBurnRate, getRunway } from "@midday/supabase/cached-queries";
import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@midday/ui/tooltip";
import { AnimatedNumber } from "../animated-number";
import { AreaChart } from "./area-chart";
import { burnRateExamleData } from "./data";

type Props = {
  value: unknown;
  defaultValue: unknown;
  currency: string;
  disabled?: boolean;
};

export async function BurnRateChart({
  value,
  defaultValue,
  currency,
  disabled,
}: Props) {
  const [{ data: burnRateData }, { data: runway }] = disabled
    ? burnRateExamleData
    : await Promise.all([
        getBurnRate({
          ...defaultValue,
          ...value,
          currency,
        }),
        getRunway({
          ...defaultValue,
          ...value,
          currency,
        }),
      ]);

  return (
    <div className={cn(disabled && "pointer-events-none select-none")}>
      <div className="space-y-2 mb-14">
        <h1 className="text-4xl font-mono">
          <AnimatedNumber
            value={calculateAvgBurnRate(burnRateData)}
            currency={currency}
          />
        </h1>

        <div className="text-sm text-[#606060] flex items-center space-x-2">
          <span>
            {runway && runway > 0
              ? `${runway} months runway`
              : "Average burn rate"}
          </span>
          {runway && runway > 0 && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icons.Info className="h-4 w-4 mt-1" />
                </TooltipTrigger>
                <TooltipContent className="px-3 py-1.5 text-xs">
                  Average burn rate / Total balance
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      <AreaChart currency={currency} data={burnRateData} />
    </div>
  );
}
