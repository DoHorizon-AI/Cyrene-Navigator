// Controls/ModelSelector.cs
//
// Model selection / 模型选择。
//
// The model is part of the current working environment, not a subject in its own right — so it
// is a chip in the composer that opens a flyout, never a page and never a "provider manager".
//
// Two deliberate departures from how most clients do this:
//
//   · Grouping is by *where the model runs* (hosted / this workspace's GPU pool / this device),
//     not by vendor. Locality is what changes your decision: cost, latency, and whether the
//     prompt leaves your network. Vendor is a detail inside the row.
//   · Each group carries one line explaining what choosing it means operationally. That single
//     line does more than a settings page full of provider toggles.
//
// 按"在哪里跑"分组，而不是按厂商 —— Provider 不该成为整个界面的中心。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class ModelSelector : Grid
{
    private readonly Button _chip;
    private readonly TextBlock _name;
    private readonly Flyout _flyout;
    private readonly INavigatorUiData _data;
    private ModelDescriptor _current;

    public event Action<ModelDescriptor>? Changed;

    public ModelDescriptor Current => _current;

    public ModelSelector(ModelDescriptor initial, INavigatorUiData data)
    {
        _current = initial;
        _data = data;

        _name = new TextBlock
        {
            Text = initial.Name,
            FontFamily = Tk.Ty.Display,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            CharacterSpacing = 10,
            Foreground = Tk.TextInk,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var content = data.Models.Count == 0
            ? Ui.HStack(Tk.Sp.S8, _name, Typo.Glyph("\uE70D", 9, Tk.Wash(Tk.Raw.Muted, 0.8)))
            : Ui.HStack(Tk.Sp.S8,
                TierMark(initial.Tier),
                _name,
                Typo.Glyph("\uE70D", 9, Tk.Wash(Tk.Raw.Muted, 0.8)));

        _chip = new Button
        {
            Content = content,
            Background = Tk.FillTransparent,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(Tk.Sp.S10, Tk.Sp.S4, Tk.Sp.S8, Tk.Sp.S6),
        };

        _flyout = new Flyout
        {
            Placement = FlyoutPlacementMode.TopEdgeAlignedLeft,
            Content = BuildPanel(),
        };
        _flyout.FlyoutPresenterStyle = BuildPresenterStyle();
        _chip.Flyout = _flyout;

        ToolTipService.SetToolTip(_chip, "Model for this session  ·  Ctrl+M");
        Children.Add(_chip);
    }

    /// <summary>Opens the picker, for the Ctrl+M accelerator.</summary>
    public void Open() => _flyout.ShowAt(_chip);

    /// <summary>
    /// The open flyout's content, so capture mode can render it. A window render does not
    /// include popups, which live in their own visual root.
    /// </summary>
    public FrameworkElement? PanelForCapture => _flyout.Content as FrameworkElement;

    // -----------------------------------------------------------------------------------------

    /// <summary>Flyout chrome: paper fill, hairline border, 6px radius, no default padding.</summary>
    private static Style BuildPresenterStyle()
    {
        var style = new Style(typeof(FlyoutPresenter));
        style.Setters.Add(new Setter(FlyoutPresenter.PaddingProperty, new Thickness(0)));
        style.Setters.Add(new Setter(Control.BackgroundProperty, Tk.FillPaper));
        style.Setters.Add(new Setter(Control.BorderBrushProperty, Tk.Line));
        style.Setters.Add(new Setter(Control.BorderThicknessProperty, Tk.Ln.Hair));
        style.Setters.Add(new Setter(Control.CornerRadiusProperty, Tk.Rad.Lg));
        style.Setters.Add(new Setter(FrameworkElement.MaxWidthProperty, 420.0));
        style.Setters.Add(new Setter(ScrollViewer.HorizontalScrollBarVisibilityProperty, ScrollBarVisibility.Disabled));
        return style;
    }

    private FrameworkElement BuildPanel()
    {
        var stack = new StackPanel { Orientation = Orientation.Vertical, Width = 400 };

        // Context header: the model belongs to a workspace, so say which one.
        var head = new Border
        {
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S10),
            Child = Ui.VStack(Tk.Sp.S4,
                Typo.Eyebrow("model for this session"),
                Typo.Meta("Changes apply to the next turn", Tk.TextSlate)),
        };
        stack.Children.Add(head);
        stack.Children.Add(Ui.HorizonRule(0.38, animate: false));

        var body = new StackPanel { Orientation = Orientation.Vertical };
        if (_data.Models.Count == 0)
        {
            body.Children.Add(new Border
            {
                Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
                Child = Typo.Meta(
                    "The connected service reported no model catalogue; switching models is unavailable.",
                    Tk.Wash(Tk.Raw.Muted, 0.9)),
            });
        }
        else
        {
            AddGroup(body, ModelTier.Hosted);
            AddGroup(body, ModelTier.Workspace);
            AddGroup(body, ModelTier.Local);
        }

        stack.Children.Add(new ScrollViewer
        {
            MaxHeight = 440,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Disabled,
            Content = body,
        });

        var footer = new Border
        {
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            Padding = new Thickness(Tk.Sp.S8, Tk.Sp.S6, Tk.Sp.S8, Tk.Sp.S6),
            Child = Ui.HStack(Tk.Sp.S4,
                Ui.Ghost("Model settings", "\uE713"),
                Ui.Spring(),
                Ui.Ghost("Compare", "\uE9D9")),
        };
        stack.Children.Add(footer);

        return stack;
    }

    private void AddGroup(StackPanel host, ModelTier tier)
    {
        var count = 0;
        foreach (var model in _data.Models)
        {
            if (model.Tier == tier)
            {
                count++;
            }
        }

        if (count == 0)
        {
            return;
        }

        host.Children.Add(new Border
        {
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S6),
            Child = Ui.VStack(3,
                Ui.HStack(Tk.Sp.S8, TierMark(tier), Typo.Eyebrow(_data.TierLabel(tier), TierBrush(tier))),
                Typo.Meta(_data.TierNote(tier), Tk.Wash(Tk.Raw.Muted, 0.9))),
        });

        foreach (var model in _data.Models)
        {
            if (model.Tier == tier)
            {
                host.Children.Add(BuildRow(model));
            }
        }
    }

    /// <summary>
    /// One model row in the brand's spec-sheet idiom: name, tagline, and the two numbers that
    /// matter, plus capability marks as tiny diamonds instead of a row of icons.
    /// </summary>
    private FrameworkElement BuildRow(ModelDescriptor model)
    {
        var available = model.Unavailable is null;

        var name = new TextBlock
        {
            Text = model.Name,
            FontFamily = Tk.Ty.Display,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = available ? Tk.TextInk : Tk.Wash(Tk.Raw.Muted, 0.7),
        };

        var tagline = Typo.Meta(
            available ? model.Tagline : model.Unavailable!,
            available ? Tk.Orchid : Tk.Wash(Tk.Raw.Muted, 0.8));

        var specs = Ui.HStack(Tk.Sp.S12,
            Typo.Mono(model.ContextLabel, Tk.TextSlate, 11.5),
            Typo.Label(model.Provider, Tk.Wash(Tk.Raw.Muted, 0.85)));

        var capabilities = Ui.HStack(Tk.Sp.S6);
        if (model.Vision)
        {
            capabilities.Children.Add(Capability("vision"));
        }

        if (model.Tools)
        {
            capabilities.Children.Add(Capability("tools"));
        }

        if (model.Thinking)
        {
            capabilities.Children.Add(Capability("thinking"));
        }

        var texts = Ui.VStack(3, Ui.HStack(Tk.Sp.S10, name, tagline), specs);

        var grid = new Grid { ColumnSpacing = Tk.Sp.S10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        grid.Children.Add(texts.At(0));
        grid.Children.Add(capabilities.At(1));

        var button = new Button
        {
            Content = grid,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.None,
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S10, Tk.Sp.S16, Tk.Sp.S10),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            IsEnabled = available,
        };
        button.PointerEntered += (_, _) =>
        {
            if (available && model.Id != _current.Id) button.Background = Tk.FillHover;
        };
        button.PointerExited += (_, _) =>
        {
            button.Background = model.Id == _current.Id ? Tk.Wash(Tk.Raw.SandDeep, 0.9) : Tk.FillTransparent;
        };
        button.Click += (_, _) => Apply(model);

        var host = new Grid();
        host.Children.Add(button);

        if (model.Id == _current.Id)
        {
            host.Children.Add(new Border
            {
                Width = Tk.Ln.Indicator,
                Background = Tk.TraceLive,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Stretch,
                Margin = new Thickness(0, 4, 0, 4),
                CornerRadius = new CornerRadius(1),
                IsHitTestVisible = false,
            });
            button.Background = Tk.Wash(Tk.Raw.SandDeep, 0.9);
        }

        if (!string.IsNullOrWhiteSpace(model.CostLabel))
        {
            ToolTipService.SetToolTip(button, model.Name + "  ·  " + model.CostLabel);
        }

        return host;
    }

    private static FrameworkElement Capability(string label) =>
        Ui.HStack(4,
            Ui.Diamond(Tk.Wash(Tk.Raw.Orchid, 0.8), Tk.FillPaper, 5),
            Typo.Label(label, Tk.Wash(Tk.Raw.Muted, 0.9)));

    private void Apply(ModelDescriptor model)
    {
        _current = model;
        _name.Text = model.Name;
        _flyout.Hide();

        // Rebuild so the selection indicator lands on the new row.
        _flyout.Content = BuildPanel();
        Changed?.Invoke(model);
    }

    /// <summary>
    /// Tier mark: a diamond whose treatment encodes locality. Filled gradient means it runs on
    /// this device, hollow orchid means the workspace pool, hollow hairline means hosted.
    /// </summary>
    public static FrameworkElement TierMark(ModelTier tier) => tier switch
    {
        ModelTier.Local => Ui.SolidDiamond(7),
        ModelTier.Workspace => Ui.Diamond(Tk.Orchid, Tk.FillPaper),
        _ => Ui.Diamond(Tk.Wash(Tk.Raw.Slate, 0.55), Tk.FillPaper),
    };

    public static Brush TierBrush(ModelTier tier) => tier switch
    {
        ModelTier.Local => Tk.Coral,
        ModelTier.Workspace => Tk.Orchid,
        _ => Tk.Wash(Tk.Raw.Slate, 0.9),
    };
}
