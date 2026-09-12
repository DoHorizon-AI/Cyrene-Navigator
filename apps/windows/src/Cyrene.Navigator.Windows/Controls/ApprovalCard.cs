// Controls/ApprovalCard.cs
//
// Approval / 审批卡片。
//
// An approval has to be impossible to miss and still feel like part of the product. A red
// warning box would achieve the first and destroy the second, so instead the card is marked the
// way the brand marks its most important surfaces: a 1.5px gradient border. It is the only
// element in a transcript that gets one, which is exactly why it reads as important.
//
// The card also has to answer one question — "should this run?" — so it carries a fact sheet
// rather than a description: target, what it writes, whether it can be undone, blast radius.
//
// 审批必须显眼但不能像网页的红色警告框。这里用品牌渐变描边 —— 全篇只有它有，所以它自然最重。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class ApprovalCard : Grid
{
    private readonly ApprovalItem _item;
    private readonly StackPanel _root;

    /// <summary>Raised after the user answers, so the timeline can update the trace node.</summary>
    public event Action<string>? Decided;

    public ApprovalCard(ApprovalItem item)
    {
        _item = item;
        _root = new StackPanel { Orientation = Orientation.Vertical, Spacing = Tk.Sp.S12 };

        if (item.Decision is null)
        {
            BuildPending();
            Children.Add(Ui.GradientCard(_root, new Thickness(Tk.Sp.S20, Tk.Sp.S16, Tk.Sp.S20, Tk.Sp.S16)));
        }
        else
        {
            BuildSettled();
            Children.Add(Ui.Card(_root, new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12)));
        }
    }

    // -----------------------------------------------------------------------------------------

    private void BuildPending()
    {
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        head.Children.Add(Ui.HStack(8,
            Ui.SolidDiamond(9),
            Typo.Eyebrow("approval required", Tk.Coral)).At(0));

        head.Children.Add(Typo.Label(
            _item.Risk == ApprovalRisk.Elevated ? "shared resource" : "routine",
            Tk.Wash(Tk.Raw.Muted, 0.85)).WithAlignment().At(2));

        _root.Children.Add(head);
        _root.Children.Add(Typo.Title(_item.Title, 17));

        var rationale = Typo.Body(_item.Rationale, Tk.TextSlate);
        rationale.MaxWidth = 640;
        _root.Children.Add(rationale);

        if (_item.Facts.Count > 0)
        {
            _root.Children.Add(BuildFacts(_item.Facts));
        }

        _root.Children.Add(new CodeBlockView(
            _item.Command,
            _item.CommandLanguage,
            maxHeight: 140,
            showHeader: false,
            showLineNumbers: false));

        _root.Children.Add(BuildActions());
    }

    /// <summary>
    /// Fact sheet in the brand's spec-sheet idiom: tracked uppercase term, plain value, hairline
    /// grid between cells. Four facts at most — a decision card is not a report.
    /// </summary>
    private static FrameworkElement BuildFacts(IReadOnlyList<(string Label, string Value)> facts)
    {
        // The 1px gaps are the container's own fill showing through, which is how the brand
        // builds its capability grid.
        var grid = new Grid
        {
            Background = Tk.Line,
            ColumnSpacing = 1,
            RowSpacing = 1,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
        };
        var columns = Math.Min(2, facts.Count);
        for (var c = 0; c < columns; c++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        }

        var rows = (int)Math.Ceiling(facts.Count / (double)columns);
        for (var r = 0; r < rows; r++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        }

        for (var i = 0; i < facts.Count; i++)
        {
            var cell = new Border
            {
                Background = Tk.FillPaper,
                Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S8, Tk.Sp.S12, Tk.Sp.S10),
                Child = Ui.VStack(3,
                    Typo.Label(facts[i].Label, Tk.TextMuted),
                    Typo.Body(facts[i].Value)),
            };
            grid.Children.Add(cell.At(i % columns, i / columns));
        }

        return grid;
    }

    private FrameworkElement BuildActions()
    {
        var approve = Ui.Solid("Approve once", "\uE73E");
        approve.Click += (_, _) => Answer("Approved once · just now");

        var always = Ui.Outline("Always allow in this session");
        always.Click += (_, _) => Answer("Allowed for this session · just now");

        var decline = Ui.Ghost("Decline");
        decline.Foreground = Tk.Danger;
        decline.Click += (_, _) => Answer("Declined · just now");

        var row = Ui.HStack(Tk.Sp.S8, approve, always, Ui.Spring(), decline);
        row.Margin = new Thickness(0, Tk.Sp.S4, 0, 0);
        return row;
    }

    private void BuildSettled()
    {
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var settled = _item.Decision?.StartsWith("Declined", StringComparison.OrdinalIgnoreCase) == true;
        head.Children.Add(Ui.HStack(8,
            Ui.Diamond(settled ? Tk.Danger : Tk.Orchid, Tk.FillPaper, 6),
            Typo.Eyebrow(settled ? "declined" : "approved", Tk.Wash(Tk.Raw.Muted, 0.9))).At(0));

        _root.Children.Add(head);
        _root.Children.Add(Typo.Body(_item.Title));
        _root.Children.Add(Typo.Meta(_item.Decision ?? string.Empty, Tk.TextMuted));
    }

    private void Answer(string decision)
    {
        _item.Decision = decision;
        _item.Node = NodeKind.Marked;

        _root.Children.Clear();
        BuildSettled();

        // Replace the gradient border with the settled hairline card.
        Children.Clear();
        Children.Add(Ui.Card(_root, new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12)));
        Ui.FadeIn(this, 200);

        Decided?.Invoke(decision);
    }
}
