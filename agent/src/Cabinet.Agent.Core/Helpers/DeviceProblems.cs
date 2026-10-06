namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// Windows Device Manager problem codes (CM_PROB_*) in plain language, with
/// the first thing support should try. Only the codes a cabinet is likely to
/// show are worded specifically.
/// </summary>
public static class DeviceProblems
{
    private static readonly Dictionary<long, string> Text = new()
    {
        [1] = "Windows has not configured this device. Reinstall its driver.",
        [3] = "The driver may be corrupted or the computer is low on memory. Reinstall the driver.",
        [10] = "The device cannot start. Unplug it, wait ten seconds and plug it into a different USB port; then update its driver.",
        [12] = "The device cannot find enough free resources. Unplug other USB devices or try a different port.",
        [14] = "The device needs the computer to restart before it works.",
        [18] = "The driver must be reinstalled.",
        [19] = "Windows cannot start the device because its registry settings are incomplete or damaged. Reinstall the driver.",
        [21] = "Windows is removing this device.",
        [22] = "The device is disabled in Device Manager.",
        [24] = "The device is not present or not working, or not all its drivers are installed. Reseat the cable.",
        [28] = "No driver is installed for this device.",
        [29] = "The device is disabled in the firmware.",
        [31] = "Windows cannot load the driver this device needs.",
        [32] = "The device's driver service is disabled.",
        [37] = "Windows cannot initialize the device driver.",
        [38] = "A previous instance of the driver is still in memory. Restart the computer.",
        [39] = "Windows cannot load the driver; it may be corrupted or missing.",
        [41] = "Windows loaded the driver but cannot find the hardware. Reseat the cable or try a different USB port.",
        [43] = "Windows stopped this device because it reported problems. Unplug it, try a different USB port, and check the cable.",
        [45] = "The device is not connected. Plug it in, or try a different USB port.",
        [47] = "The device was prepared for safe removal. Unplug it and plug it back in.",
        [48] = "The driver has been blocked from starting because of known problems.",
        [52] = "Windows cannot verify the driver's digital signature.",
    };

    public static string? Describe(long? code) => code switch
    {
        null or 0 => null,
        { } c when Text.TryGetValue(c, out string? text) => text,
        { } c => $"Windows reports device problem code {c}.",
    };
}
